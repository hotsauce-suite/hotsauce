// The extension's manifest, kept apart from the build so a test can read it.

export function makeManifest(productName: string, version: string): Record<string, unknown> {
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' }
  return {
    manifest_version: 3,
    name: productName,
    version,
    description: `Take notes on Google Meet calls with ${productName}, and save pages to read later.`,
    minimum_chrome_version: '116',
    icons: { ...icons, 128: 'icons/icon-128.png' },
    action: { default_title: productName, default_popup: 'popup.html', default_icon: icons },
    // The setup page (docs/PLAN-extension-setup.md) is also Options on the icon's right-click menu.
    options_ui: { page: 'setup.html', open_in_tab: true },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['tabCapture', 'storage', 'activeTab', 'contextMenus', 'scripting'],
    host_permissions: ['https://meet.google.com/*'],
    // Asked for one site at a time, when the person connects to their server.
    optional_host_permissions: ['https://*/*', 'http://localhost/*'],
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+H' } },
    },
  }
}
