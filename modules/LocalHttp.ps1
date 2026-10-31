<#
  Capstan loopback-only HTTP adapter (derived from SnapShackle, formerly Lasso). Uses TcpListener instead of HttpListener,
  so ordinary users do not need a Windows HTTP.sys URL ACL reservation.
  One request per connection, Connection: close, no chunked transfer encoding.
  Body and header limits are enforced before handing requests to the app.
  Bodies are read into memory (30 MB cap), except for /api/files (the on-disk library, modules/Library.ps1):
  those requests hand over an unread, length-bounded stream so a chunk is written to disk in 1 MB buffers,
  and a file download is streamed from disk in 1 MB buffers (Response.SetStream).
#>
if (-not ('Capstan.Transport.Server' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Net;
using System.Net.Sockets;
using System.Collections.Specialized;
using System.Globalization;

namespace Capstan.Transport {
    public sealed class Server : IDisposable {
        public readonly TcpListener Listener;
        public int Port { get { return ((IPEndPoint)Listener.LocalEndpoint).Port; } }
        public Server(int preferredPort, int scanCount) {
            if (preferredPort < 1024 || preferredPort > 65535) throw new ArgumentOutOfRangeException("preferredPort");
            if (scanCount < 1 || scanCount > 500) throw new ArgumentOutOfRangeException("scanCount");
            SocketException last = null;
            for (int i=0; i<scanCount; i++) {
                int port=preferredPort+i;
                if (port>65535) port=1024+(port-65536);
                TcpListener listener=null;
                try {
                    listener=new TcpListener(IPAddress.Loopback,port);
                    listener.Start(32);
                    Listener=listener;
                    return;
                } catch (SocketException ex) {
                    last=ex;
                    if (listener!=null) listener.Stop();
                    // Only try the next port on a collision or a port-specific denial.
                    if (ex.SocketErrorCode!=SocketError.AddressAlreadyInUse &&
                        ex.SocketErrorCode!=SocketError.AccessDenied &&
                        ex.SocketErrorCode!=SocketError.AddressNotAvailable) throw;
                }
            }
            // OS-assigned port, acquired atomically by binding to zero.
            try {
                Listener=new TcpListener(IPAddress.Loopback,0);
                Listener.Start(32);
            } catch {
                throw new InvalidOperationException("Unable to bind a loopback TCP listener. Check workstation/network restrictions and localhost access.",last);
            }
        }
        public ClientContext Accept() { return new ClientContext(Listener.AcceptTcpClient(),Port); }
        // Waits up to timeoutMs for a connection and returns null if none arrived, so the host loop
        // can run its lifecycle tick (and Ctrl+C is honoured) between requests.
        public ClientContext TryAccept(int timeoutMs) {
            if (!Listener.Server.Poll(timeoutMs*1000,SelectMode.SelectRead)) return null;
            return Accept();
        }
        public void Dispose() { Listener.Stop(); }
    }

    // The unread body of a request, bounded by its Content-Length. The library routes read it in 1 MB
    // buffers; whatever is left is dropped before the connection closes so a refusal still reaches the client.
    public sealed class BodyStream : Stream {
        readonly Stream inner;
        readonly long total;
        long remaining;
        public BodyStream(Stream source, long length) { inner=source; total=length; remaining=length; }
        public long Remaining { get { return remaining; } }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return total; } }
        public override long Position { get { return total-remaining; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) {
            if (remaining<=0 || count<=0) return 0;
            int want=(int)Math.Min((long)count,remaining);
            int got=inner.Read(buffer,offset,want);
            if (got<=0) throw new IOException("Incomplete request body");
            remaining-=got;
            return got;
        }
        public void Discard() {
            byte[] sink=new byte[65536];
            while (remaining>0) { if (Read(sink,0,sink.Length)<=0) break; }
        }
    }

    public sealed class Request {
        public Uri Url { get; internal set; }
        public string HttpMethod { get; internal set; }
        public NameValueCollection Headers { get; internal set; }
        public Stream InputStream { get; internal set; }
        public long ContentLength64 { get; internal set; }
        public IPEndPoint RemoteEndPoint { get; internal set; }
        public NameValueCollection QueryString {
            get {
                NameValueCollection values=new NameValueCollection();
                string q=Url.Query.TrimStart('?');
                if (q.Length==0) return values;
                foreach (string segment in q.Split('&')) {
                    int eq=segment.IndexOf('=');
                    string key=eq<0?segment:segment.Substring(0,eq);
                    string value=eq<0?"":segment.Substring(eq+1);
                    values.Add(WebUtility.UrlDecode(key),WebUtility.UrlDecode(value));
                }
                return values;
            }
        }
    }

    public sealed class Response {
        readonly NetworkStream stream;
        bool closed=false;
        public int StatusCode=200;
        public string ContentType="application/octet-stream";
        public NameValueCollection Headers=new NameValueCollection(StringComparer.OrdinalIgnoreCase);
        public long ContentLength64;
        public MemoryStream OutputStream=new MemoryStream();
        byte[] immediateBody=null;
        Stream bodyStream=null;
        long bodyStreamLength=0;
        const int StreamChunk=1048576;
        // Avoid copying large responses into MemoryStream and then cloning them via ToArray().
        public void SetBody(byte[] body) { immediateBody=body ?? new byte[0]; }
        // Sends a stream (a file) in buffers of at most 1 MB instead of holding it in memory.
        // Close() writes exactly `length` bytes and then disposes the stream.
        public void SetStream(Stream source,long length) {
            if (source==null || length<0) throw new ArgumentException("source");
            bodyStream=source;
            bodyStreamLength=length;
        }
        public Response(NetworkStream s) { stream=s; }
        public void Close() {
            if (closed) return;
            closed=true;
            if (bodyStream!=null) {
                try {
                    byte[] head=BuildHeader(bodyStreamLength);
                    stream.Write(head,0,head.Length);
                    byte[] chunk=new byte[StreamChunk];
                    long left=bodyStreamLength;
                    while (left>0) {
                        int got=bodyStream.Read(chunk,0,(int)Math.Min((long)chunk.Length,left));
                        if (got<=0) throw new IOException("The file ended before its announced length");
                        stream.Write(chunk,0,got);
                        left-=got;
                    }
                    stream.Flush();
                } finally {
                    bodyStream.Dispose();
                    OutputStream.Dispose();
                }
                return;
            }
            ArraySegment<byte> buffered;
            byte[] body;
            int length;
            int offset;
            if (immediateBody!=null) { body=immediateBody; length=body.Length; offset=0; }
            else if (OutputStream.TryGetBuffer(out buffered)) { body=buffered.Array; offset=buffered.Offset; length=buffered.Count; }
            else { body=OutputStream.ToArray(); length=body.Length; offset=0; }
            byte[] header=BuildHeader(length);
            stream.Write(header,0,header.Length);
            if (length>0) stream.Write(body,offset,length);
            stream.Flush();
            OutputStream.Dispose();
        }
        byte[] BuildHeader(long length) {
            // HTTP reason phrases: the union of every route family (files, captures, and the host features that follow).
            string reason=StatusCode==200?"OK":StatusCode==206?"Partial Content":StatusCode==400?"Bad Request":StatusCode==403?"Forbidden":StatusCode==404?"Not Found":StatusCode==405?"Method Not Allowed":StatusCode==409?"Conflict":StatusCode==413?"Payload Too Large":StatusCode==415?"Unsupported Media Type":StatusCode==416?"Range Not Satisfiable":StatusCode==422?"Unprocessable Entity":StatusCode==429?"Too Many Requests":StatusCode==501?"Not Implemented":StatusCode==507?"Insufficient Storage":"Internal Server Error";
            StringBuilder sb=new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(StatusCode).Append(' ').Append(reason).Append("\r\n");
            sb.Append("Connection: close\r\nContent-Type: ").Append(ContentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            foreach (string key in Headers.AllKeys) {
                foreach (string value in Headers.GetValues(key)) {
                    if (key.IndexOfAny(new char[]{'\r','\n',':'})>=0 || value.IndexOfAny(new char[]{'\r','\n'})>=0) continue;
                    sb.Append(key).Append(": ").Append(value).Append("\r\n");
                }
            }
            sb.Append("\r\n");
            return Encoding.ASCII.GetBytes(sb.ToString());
        }
    }

    public sealed class ClientContext : IDisposable {
        const int MaxHeaders=32768;
        const int MaxBody=30000000;
        // Bodies of /api/files requests are not buffered; the library routes enforce their own, much
        // smaller limits and answer 413 above them. This only bounds how much is read to drop a refused body.
        const int MaxStreamBody=67108864;
        readonly TcpClient client;
        public Request Request { get; private set; }
        public Response Response { get; private set; }
        static bool IsStreamedTarget(string target) {
            return target=="/api/files" || target.StartsWith("/api/files/",StringComparison.Ordinal) || target.StartsWith("/api/files?",StringComparison.Ordinal);
        }
        public ClientContext(TcpClient tcp,int port) {
            client=tcp;
            try {
                client.ReceiveTimeout=15000;
                client.SendTimeout=15000;
                NetworkStream ns=client.GetStream();
                // NetworkStream.ReadByte can make a socket read for every HTTP header byte.
                // A buffered reader also handles POST body bytes, preserving read-ahead.
                BufferedStream incoming=new BufferedStream(ns,16384);
                MemoryStream h=new MemoryStream();
                int state=0;
                while (true) {
                    int b=incoming.ReadByte();
                    if (b<0) throw new IOException("Client closed while sending headers");
                    if (h.Length>=MaxHeaders) throw new InvalidDataException("HTTP request headers exceed 32 KiB");
                    h.WriteByte((byte)b);
                    state=(state==0&&b==13)?1:(state==1&&b==10)?2:(state==2&&b==13)?3:(state==3&&b==10)?4:(b==13?1:0);
                    if (state==4) break;
                }
                string raw=Encoding.ASCII.GetString(h.ToArray());
                string[] lines=raw.Split(new string[]{"\r\n"},StringSplitOptions.None);
                string[] requestLine=lines[0].Split(' ');
                if (requestLine.Length!=3 || requestLine[2]!="HTTP/1.1" ||
                   (requestLine[0]!="GET" && requestLine[0]!="POST" && requestLine[0]!="PUT" && requestLine[0]!="DELETE") ||
                   !requestLine[1].StartsWith("/",StringComparison.Ordinal) || requestLine[1].StartsWith("//",StringComparison.Ordinal))
                    throw new InvalidDataException("Unsupported HTTP request");
                NameValueCollection headers=new NameValueCollection(StringComparer.OrdinalIgnoreCase);
                for (int i=1;i<lines.Length && lines[i].Length>0;i++) {
                    int sep=lines[i].IndexOf(':');
                    if (sep<=0) throw new InvalidDataException("Malformed HTTP header");
                    string key=lines[i].Substring(0,sep).Trim(),value=lines[i].Substring(sep+1).Trim();
                    if (key.Length==0 || value.IndexOf('\0')>=0 || headers[key]!=null) throw new InvalidDataException("Duplicate/invalid HTTP header");
                    headers.Add(key,value);
                }
                string expectedHost="127.0.0.1:"+port.ToString(CultureInfo.InvariantCulture);
                if (headers["Host"]!=expectedHost) throw new InvalidDataException("Invalid Host header");
                if (headers["Transfer-Encoding"]!=null || headers["Expect"]!=null) throw new InvalidDataException("Chunked/Expect requests are unsupported");
                bool streamed=IsStreamedTarget(requestLine[1]);
                int length=0;
                if (headers["Content-Length"]!=null && (!int.TryParse(headers["Content-Length"],NumberStyles.None,CultureInfo.InvariantCulture,out length) || length<0 || length>(streamed?MaxStreamBody:MaxBody)))
                    throw new InvalidDataException("HTTP request body size invalid");
                // GET and DELETE may omit Content-Length (a browser sends none for a DELETE without a body).
                if ((requestLine[0]=="POST" || requestLine[0]=="PUT") && headers["Content-Length"]==null) throw new InvalidDataException("Content-Length is required");
                Stream bodyStream;
                if (streamed) {
                    bodyStream=new BodyStream(incoming,length);
                } else {
                    byte[] body=new byte[length];
                    int n=0;
                    while (n<length) {
                        int got=incoming.Read(body,n,length-n);
                        if (got<=0) throw new IOException("Incomplete request body");
                        n+=got;
                    }
                    bodyStream=new MemoryStream(body,false);
                }
                Uri uri=new Uri("http://"+expectedHost+requestLine[1],UriKind.Absolute);
                if (uri.Host!="127.0.0.1" || uri.Port!=port) throw new InvalidDataException("Invalid URI authority");
                Request=new Request{Url=uri,HttpMethod=requestLine[0],Headers=headers,InputStream=bodyStream,ContentLength64=length,RemoteEndPoint=(IPEndPoint)client.Client.RemoteEndPoint};
                Response=new Response(ns);
            } catch { client.Close(); throw; }
        }
        public void Dispose() {
            if (Request!=null) {
                BodyStream unread=Request.InputStream as BodyStream;
                if (unread!=null && unread.Remaining>0) {
                    // Drop a body nobody read (a refusal), or closing would reset the connection and the client would lose the answer.
                    try { client.ReceiveTimeout=3000; unread.Discard(); } catch { }
                }
                Request.InputStream.Dispose();
            }
            client.Close();
        }
    }
}
'@
}