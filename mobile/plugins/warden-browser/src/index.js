/**
 * Entry point for the local Capacitor plugin package.
 *
 * The app registers the plugin itself (`mobile/src/warden-browser.ts`) so the
 * shell keeps one import site, but the package needs a resolvable `main` for
 * `npm install` and `cap sync` to treat it as a plugin rather than a folder of
 * Swift files.
 */
module.exports = {}
