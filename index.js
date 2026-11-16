/**
 * Host half of the reasoning auto-translation plugin.
 *
 * The whole feature lives in the browser half (`client.js`): it replaces the
 * expanded reasoning body, translates the settled paragraphs through the
 * Microsoft Edge translation endpoint, and can always switch back to the
 * original text. Nothing is written to the Session log, and the model context
 * never changes, so this Host entry intentionally has no behaviour and only
 * gives the bundle a visible row on the Plugins page.
 */
export function apply() {}
