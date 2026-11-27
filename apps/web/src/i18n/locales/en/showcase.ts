import type { FeatureId } from '@relay/shared';

/** The feature tour: shown once after the first-start question, and again from Settings or the command palette. */
export const showcase = {
  title: 'What Relay does for you',
  lede: 'A quick look at the features that are switched on. Open one now, or come back to this tour any time.',
  slides: 'Tour slides',
  skip: 'Skip tour',
  done: 'Done',
  open: 'Open',
  openSettings: 'Set up',
  needsNotion: 'Needs Notion',
  needsNotionHint: 'Connect Notion in Settings first.',
  reopen: 'Take the feature tour',
  groups: {
    code: 'Code & review',
    ship: 'Build & ship',
    plan: 'Planning',
  },
  groupLede: {
    code: 'Merge requests and the code inside them.',
    ship: 'From agent sessions to a build on a test device.',
    plan: 'Cards, sprints and your working days.',
  },
  final: {
    rail: 'Set up',
    title: 'Finish the setup',
    body: 'Some features wait for a connection or a token. The setup checklist at the top of Settings lists what is still missing and what it unlocks.',
    allSet:
      'Everything is set up. You can switch features on or off in Settings > General > Features.',
    missing_one: '{{count}} thing still to set up',
    missing_other: '{{count}} things still to set up',
    link: 'Open the setup checklist',
  },
  features: {
    board: 'Your Notion cards by status, with their merge requests.',
    mrInbox: 'Merge requests of your repos, sorted by what needs you.',
    codeReview: 'Read the diff of a merge request or two branches of your repos.',
    reviews:
      'Merge requests in any project where you are a reviewer or were mentioned. Needs a personal GitLab token.',
    cockpit: 'Coding agent sessions on your cards, in their own worktrees.',
    testBench: 'Check a running app against its Figma frames.',
    release: 'Version merge requests, tags and the release train.',
    builds: 'Flutter builds, uploads and the build queue.',
    syncHealth: 'Cards and merge requests that disagree, with one-click fixes.',
    kpi: 'Points, effort and SLA presets for teams that track them.',
    sprints: 'Sprint capacity and what fits in it.',
    calendar: 'Your Google Calendar meetings, with a floating alert while one is under way.',
    reader: 'Markdown and text documents to read in a calm column, on any device.',
  } satisfies Record<FeatureId, string>,
};
