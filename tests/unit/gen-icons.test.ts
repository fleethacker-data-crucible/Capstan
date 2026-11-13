// tools/gen-icons.mjs turns Lucide SVG into JSX. Comments have to come out completely:
// a one-shot `<!--...-->` replace leaves `<!--` in the generated source.
import { describe, expect, test } from 'bun:test';
import { iconInner, stripHtmlComments } from '../../tools/gen-icons.mjs';

const svg = (inner: string, comment = '') =>
  `${comment}<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${inner}"/></svg>`;

describe('gen-icons comment stripping', () => {
  test('a normal comment is removed and the icon body is unchanged', () => {
    expect(stripHtmlComments('before<!-- note -->after')).toBe('beforeafter');
    expect(iconInner(svg('M12 2v10', '<!-- lucide -->\n'))).toBe('<path d="M12 2v10"/>');
  });

  test('kebab attributes are camel-cased for JSX', () => {
    expect(iconInner(svg('M1 1'))).toBe('<path d="M1 1"/>');
    const withStroke = '<svg xmlns="http://www.w3.org/2000/svg"><path stroke-width="2" d="M1 1"/></svg>';
    expect(iconInner(withStroke)).toBe('<path strokeWidth="2" d="M1 1"/>');
  });

  test('a comment closed with --!> is removed', () => {
    expect(stripHtmlComments('<!-- secret --!><path />')).toBe('<path />');
  });

  test('cutting an inner comment cannot leave <!--', () => {
    expect(stripHtmlComments('<!<!--foo-->')).toBe('<!');
    expect(stripHtmlComments('<!<!--foo-->--')).toBe('');
    expect(stripHtmlComments('<!<!--foo-->text')).toBe('<!text');
    expect(stripHtmlComments('keep')).toBe('keep');
  });

  test('an unclosed comment is dropped through the end of the file', () => {
    expect(stripHtmlComments('before<!-- never closed')).toBe('before');
  });

  test('empty comments and reassembled markers match the shared helper', () => {
    expect(stripHtmlComments('a<!-- x -->b')).toBe('ab');
    expect(stripHtmlComments('a<!-->b')).toBe('ab');
    expect(stripHtmlComments('a<!--->b')).toBe('ab');
    expect(stripHtmlComments('a<!-- x --!>b')).toBe('ab');
    expect(stripHtmlComments('a<!--unclosed <path d="1"/>')).toBe('a');
    expect(stripHtmlComments('<!<!---->-->x')).toBe('x');
    expect(stripHtmlComments('<<!-- -->!--<path/>-->y')).toBe('y');
    expect(stripHtmlComments('<path d="1"/>')).toBe('<path d="1"/>');
  });
});
