// VS Code settings use iconv-style names, not always TextDecoder labels.
// Keep codecs without a TextDecoder equivalent unsupported; never guess a substitute.
const encodingAliases = new Map([
  ["shiftjis", "shift_jis"],
  ["eucjp", "euc-jp"],
  ["euckr", "euc-kr"],
  ["koi8r", "koi8-r"],
  ["koi8u", "koi8-u"],
  ["macroman", "macintosh"],
  ["cp950", "big5"],
  ["big5hkscs", "big5-hkscs"],
]);

/** Match VS Code's BOM removal and line-ending normalization, never replacement decoding. */
export function diagnosticDiskText(bytes: Buffer, configuredEncoding: string, eol: "\n" | "\r\n"): string {
  let encoding = configuredEncoding;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf16be";
  encoding = (encodingAliases.get(encoding) ?? encoding)
    .replace(/^utf(8|16le|16be)(?:bom)?$/, "utf-$1")
    .replace(/^windows(\d+)$/, "windows-$1")
    .replace(/^iso8859(\d+)$/, "iso-8859-$1");
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n|\r|\n/g, eol);
  } catch {
    throw new Error("Cannot verify diagnostic file encoding. Save as UTF-8 or set files.encoding and retry.");
  }
}
