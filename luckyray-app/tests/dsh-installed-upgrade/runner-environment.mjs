// Never pass the Actions runtime, repository credentials or transfer Secret to
// the installed application, its engine, installer or the ordinary reopen.
const WINDOWS_KEYS = new Set([
  'systemroot','windir','systemdrive','comspec','path','pathext','temp','tmp',
  'appdata','localappdata','userprofile','homedrive','homepath','username',
  'userdomain','programfiles','programfiles(x86)','programw6432','programdata',
  'allusersprofile','public','os','processor_architecture','number_of_processors',
]);
export function installedApplicationEnvironment(source, proxyUrl) {
  const environment = Object.fromEntries(Object.entries(source).filter(([name, value]) => WINDOWS_KEYS.has(name.toLowerCase()) && typeof value === 'string'));
  const debug = {WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9391'};
  // Explicit fixture preparation has no proxy at all. Inherited CI/user proxy
  // variables are excluded by the same allowlist, not copied into this phase.
  if (proxyUrl === null) return {...environment, ...debug};
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('test-process-loopback-proxy-required');
  }
  return {...environment, HTTPS_PROXY:proxyUrl, HTTP_PROXY:proxyUrl,
    https_proxy:proxyUrl, http_proxy:proxyUrl,
    NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost',
    ...debug};
}
