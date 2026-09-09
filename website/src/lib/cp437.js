// CP437 -> Unicode, for decoding ANSI art at build time.
// Only the high half needs mapping; 0x00-0x7F is ASCII.
//
// Note: unlike a live terminal session, art files legitimately use the C0 range
// (0x01-0x1F) as *graphics* -- smiley faces, arrows, musical notes. decodeByte()
// therefore takes a `graphicsC0` flag so art rendering and terminal streaming can
// share this table without disagreeing about control codes.

// prettier-ignore
const LOW_GRAPHICS = [
    ' ', '☺', '☻', '♥', '♦', '♣', '♠', '•', // 00-07
    '◘', '○', '◙', '♂', '♀', '♪', '♫', '☼', // 08-0F
    '►', '◄', '↕', '‼', '¶', '§', '▬', '↨', // 10-17
    '↑', '↓', '→', '←', '∟', '↔', '▲', '▼', // 18-1F
];

// prettier-ignore
const HIGH = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç',
    'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
    'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù',
    'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
    'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º',
    '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
    '░', '▒', '▓', '│', '┤', '╡', '╢', '╖',
    '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
    '└', '┴', '┬', '├', '─', '┼', '╞', '╟',
    '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
    '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫',
    '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
    'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ',
    'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
    '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈',
    '°', '∙', '·', '√', 'ⁿ', '²', '■', ' ',
];

/**
 * @param {number} b byte value 0-255
 * @param {boolean} graphicsC0 render 0x00-0x1F as DOS glyphs rather than controls
 */
export function decodeByte(b, graphicsC0 = false) {
    if (b >= 0x80) return HIGH[b - 0x80];
    if (b < 0x20) return graphicsC0 ? LOW_GRAPHICS[b] : String.fromCharCode(b);
    if (b === 0x7f) return graphicsC0 ? '⌂' : String.fromCharCode(b);
    return String.fromCharCode(b);
}

/**
 * Decode a run of CP437 bytes for a live terminal session.
 * C0 is left as control codes here -- ESC, CR, LF and friends must keep working.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeCp437(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += decodeByte(bytes[i], false);
    return out;
}

// Reverse map for encoding keystrokes back to the board.
const REVERSE = new Map();
for (let i = 0; i < HIGH.length; i++) REVERSE.set(HIGH[i], 0x80 + i);

/**
 * Encode a Unicode string from the keyboard back to CP437 bytes.
 * Characters with no CP437 equivalent become '?' rather than vanishing, so the
 * byte stream stays aligned with what the user actually typed.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function encodeCp437(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        out[i] = code < 0x80 ? code : (REVERSE.get(str[i]) ?? 0x3f);
    }
    return out;
}
