<#
  Capstan loopback-only HTTP adapter (derived from SnapShackle, formerly Lasso). Uses TcpListener instead of HttpListener,
  so ordinary users do not need a Windows HTTP.sys URL ACL reservation.
  One request per connection, Connection: close, no chunked transfer encoding.
  Body and header limits are enforced before handing requests to the app.
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
        public void Dispose() { Listener.Stop(); }
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
        // Avoid copying large responses into MemoryStream and then cloning them via ToArray().
        public void SetBody(byte[] body) { immediateBody=body ?? new byte[0]; }
        public Response(NetworkStream s) { stream=s; }
        public void Close() {
            if (closed) return;
            closed=true;
            ArraySegment<byte> buffered;
            byte[] body;
            int length;
            int offset;
            if (immediateBody!=null) { body=immediateBody; length=body.Length; offset=0; }
            else if (OutputStream.TryGetBuffer(out buffered)) { body=buffered.Array; offset=buffered.Offset; length=buffered.Count; }
            else { body=OutputStream.ToArray(); length=body.Length; offset=0; }
            string reason=StatusCode==200?"OK":StatusCode==400?"Bad Request":StatusCode==403?"Forbidden":StatusCode==404?"Not Found":StatusCode==409?"Conflict":StatusCode==413?"Payload Too Large":StatusCode==501?"Not Implemented":"Internal Server Error";
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
            byte[] header=Encoding.ASCII.GetBytes(sb.ToString());
            stream.Write(header,0,header.Length);
            if (length>0) stream.Write(body,offset,length);
            stream.Flush();
            OutputStream.Dispose();
        }
    }

    public sealed class ClientContext : IDisposable {
        const int MaxHeaders=32768;
        const int MaxBody=30000000;
        readonly TcpClient client;
        public Request Request { get; private set; }
        public Response Response { get; private set; }
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
                int length=0;
                if (headers["Content-Length"]!=null && (!int.TryParse(headers["Content-Length"],NumberStyles.None,CultureInfo.InvariantCulture,out length) || length<0 || length>MaxBody))
                    throw new InvalidDataException("HTTP request body size invalid");
                if (requestLine[0]!="GET" && headers["Content-Length"]==null) throw new InvalidDataException("Content-Length is required");
                byte[] body=new byte[length];
                int n=0;
                while (n<length) {
                    int got=incoming.Read(body,n,length-n);
                    if (got<=0) throw new IOException("Incomplete request body");
                    n+=got;
                }
                Uri uri=new Uri("http://"+expectedHost+requestLine[1],UriKind.Absolute);
                if (uri.Host!="127.0.0.1" || uri.Port!=port) throw new InvalidDataException("Invalid URI authority");
                Request=new Request{Url=uri,HttpMethod=requestLine[0],Headers=headers,InputStream=new MemoryStream(body,false),ContentLength64=length,RemoteEndPoint=(IPEndPoint)client.Client.RemoteEndPoint};
                Response=new Response(ns);
            } catch { client.Close(); throw; }
        }
        public void Dispose() { if (Request!=null) Request.InputStream.Dispose(); client.Close(); }
    }
}
'@
}