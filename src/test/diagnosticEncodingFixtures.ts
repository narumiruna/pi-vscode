// VS Code's SUPPORTED_ENCODINGS (1.106.0 and upstream 2026-09-21).
// Golden non-ASCII bytes were independently encoded/round-tripped with VS Code's
// bundled iconv-lite. Tests have no dependency on that encoder or network access.
export const diagnosticEncodingFixtures = [
  { encoding: "utf8", hex: "e697a5e69cac0a", text: "日本\n" },
  { encoding: "utf8bom", hex: "efbbbfe697a5e69cac0a", text: "日本\n" },
  // A BOM prevents VS Code's binary detector from rejecting short CJK-only UTF-16.
  { encoding: "utf16le", hex: "fffee5652c670a00", text: "日本\n" },
  { encoding: "utf16be", hex: "feff65e5672c000a", text: "日本\n" },
  { encoding: "windows1252", hex: "e90a", text: "é\n" },
  { encoding: "iso88591", hex: "e90a", text: "é\n" },
  { encoding: "iso88593", hex: "a10a", text: "Ħ\n" },
  { encoding: "iso885915", hex: "a40a", text: "€\n" },
  { encoding: "macroman", hex: "800a", text: "Ä\n" },
  { encoding: "windows1256", hex: "d40a", text: "ش\n" },
  { encoding: "iso88596", hex: "d40a", text: "ش\n" },
  { encoding: "windows1257", hex: "e20a", text: "ā\n" },
  { encoding: "iso88594", hex: "e00a", text: "ā\n" },
  { encoding: "iso885914", hex: "a80a", text: "Ẁ\n" },
  { encoding: "windows1250", hex: "a30a", text: "Ł\n" },
  { encoding: "iso88592", hex: "a30a", text: "Ł\n" },
  { encoding: "windows1251", hex: "df0a", text: "Я\n" },
  { encoding: "cp866", hex: "9f0a", text: "Я\n" },
  { encoding: "iso88595", hex: "cf0a", text: "Я\n" },
  { encoding: "koi8r", hex: "f10a", text: "Я\n" },
  { encoding: "koi8u", hex: "b70a", text: "Ї\n" },
  { encoding: "iso885913", hex: "cb0a", text: "Ė\n" },
  { encoding: "windows1253", hex: "d90a", text: "Ω\n" },
  { encoding: "iso88597", hex: "d90a", text: "Ω\n" },
  { encoding: "windows1255", hex: "e00a", text: "א\n" },
  { encoding: "iso88598", hex: "e00a", text: "א\n" },
  { encoding: "iso885910", hex: "af0a", text: "Ŋ\n" },
  { encoding: "iso885916", hex: "aa0a", text: "Ș\n" },
  { encoding: "windows1254", hex: "fe0a", text: "ş\n" },
  { encoding: "iso88599", hex: "fe0a", text: "ş\n" },
  { encoding: "windows1258", hex: "c30a", text: "Ă\n" },
  { encoding: "gbk", hex: "d6d00a", text: "中\n" },
  { encoding: "gb18030", hex: "953282360a", text: "𠀀\n" },
  { encoding: "cp950", hex: "a4a40a", text: "中\n" },
  { encoding: "big5hkscs", hex: "a4a40a", text: "中\n" },
  { encoding: "shiftjis", hex: "93fa967b0a", text: "日本\n" },
  { encoding: "eucjp", hex: "c6fccbdc0a", text: "日本\n" },
  { encoding: "euckr", hex: "c7d10a", text: "한\n" },
  { encoding: "windows874", hex: "a10a", text: "ก\n" },
  { encoding: "iso885911", hex: "a10a", text: "ก\n" },
  { encoding: "gb2312", hex: "d6d00a", text: "中\n" },
] as const;

// Label compatibility does not imply identical codec tables in every Node/ICU
// version. Capture must reject only when actual decoding differs from the editor.
export const diagnosticEncodingAgreementFixtures = [
  { encoding: "big5hkscs", canonicalEncoding: "big5-hkscs", hex: "9dee0a", text: "㗎\n" },
  { encoding: "iso88591", canonicalEncoding: "iso-8859-1", hex: "800a", text: "\u0080\n" },
] as const;

// Node TextDecoder has no equivalent for these VS Code settings. cp857 was added
// after the minimum VS Code version. Never substitute a merely similar codec.
export const unsupportedDiagnosticEncodings = [
  "cp437",
  "cp852",
  "cp1125",
  "cp857",
  "koi8ru",
  "koi8t",
  "cp865",
  "cp850",
] as const;

export const aliasedDiagnosticEncodings = [
  "macroman",
  "koi8r",
  "koi8u",
  "cp950",
  "big5hkscs",
  "shiftjis",
  "eucjp",
  "euckr",
] as const;
