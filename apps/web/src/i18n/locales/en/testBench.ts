/** Test Bench: the device mirror and its controls, and the web dev server with its preview. */
export const testBench = {
  mirror: {
    noAnswer:
      'The phone did not answer in time. Unlock it (or check the emulator is running), then press Reconnect.',
  },
  title: {
    device: 'Test on device',
    web: 'Test in browser',
  },
  panes: {
    checks: 'Checks',
    phone: 'Phone',
    preview: 'Preview',
    design: 'Design',
  },
  web: {
    noWorkspace:
      'No cockpit workspace holds this repo, so the dev server cannot be started from here.',
    addWorkspace: 'Add one',
    wrongBranch:
      '{{ws}} has <0>{{branch}}</0> checked out, not this branch. Running checks it out first.',
    stopFirst: 'Stop the dev server first',
    checkoutTitle: 'Check out {{branch}} in {{ws}}',
    checkoutNow: 'Check out now',
    checkoutThenRun: 'Checks out {{branch}} first, then runs',
    script: 'Script',
    scriptPick: 'Script…',
    noScripts: 'package.json has no scripts to run.',
    run: 'Run dev server',
    restart: 'Restart',
    stop: 'Stop',
    logs: 'Logs',
    usesPm: '{{pm}} run {{script}}',
    preview: {
      label: 'Preview',
      idle: 'Run the dev server to see the app here.',
      starting: 'Starting the dev server…',
      startingHint:
        'Dependencies are installed first when they are missing or out of date. The log shows progress.',
      exited: 'The dev server is not running. Run it again, or open the log to see how it ended.',
      width: 'Preview width',
      mobile: 'Mobile',
      tablet: 'Tablet',
      desktop: 'Desktop',
      reload: 'Reload',
      open: 'Open in browser',
      frameTitle: 'Preview of {{url}}',
      blocked:
        'The app refuses to be shown inside another page (X-Frame-Options or CSP frame-ancestors). Open it in the browser instead.',
      remote:
        'The dev server runs on the Mac, so the preview only shows when Relay is open in a browser on that Mac. From here, open the address on the Mac.',
    },
  },
};
