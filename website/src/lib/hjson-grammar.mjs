//  HJSON highlighting that actually tokenises ENiGMA's config snippets.
//
//  Shiki ships an Hjson grammar, but its top level is:
//
//      [ #comments, #value, <illegal> ]
//
//  ...that is, it expects the document to BE a value. Every HJSON block in
//  these docs is instead a braceless fragment lifted out of config.hjson:
//
//      contentServers: {
//          gopher: {
//              enabled: true
//
//  With no leading `{` the #object rule never matches, so the first line falls
//  through to #string -> #ustring -- an unquoted Hjson string, which by
//  definition runs to end of line. The result is that every line renders as one
//  flat string-coloured span: no keys, no punctuation, no booleans, no numbers.
//  All 151 hjson blocks in the docs were affected.
//
//  HJSON genuinely permits a braceless root object, so the fix is to let the
//  top level be object CONTENT as well as a value. #objectContent is the rule
//  the grammar already uses for the inside of `{ ... }`, so key/value/comment
//  handling comes along with it, correct by construction.
//
//  Ordering matters: an explicit `{` or `[` must still win, and the bare-value
//  case stays last so a snippet that really is just a value keeps working.
import bundled from '@shikijs/langs/hjson';

const source = Array.isArray(bundled) ? bundled[0] : (bundled.default ?? bundled);

//  Registered under its own name with `hjson` aliased onto it. Reusing the name
//  `hjson` does not work: Expressive Code skips any language already in
//  `loadedLanguages`, so the bundled grammar simply wins and this one is
//  silently dropped.
export const hjsonFragment = {
    ...source,
    name: 'hjson-fragment',
    aliases: ['hjson'],
    patterns: [
        { include: '#comments' },
        { include: '#object' }, //  a normal, brace-wrapped object
        { include: '#array' },
        { include: '#objectContent' }, //  a braceless fragment: what our docs use
        { include: '#value' }, //  a bare scalar
        { match: '\\S', name: 'invalid.illegal.excess-characters.hjson' },
    ],
};

export default hjsonFragment;
