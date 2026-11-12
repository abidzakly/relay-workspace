import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { FeatureGate } from '@/components/FeatureGate';
import { Layout } from '@/components/Layout';
import { useUiStore } from '@/store/ui';

// Each view is its own chunk, so the first load carries only the shell and the page it opens.
const Audit = lazy(() => import('@/views/Audit').then((m) => ({ default: m.Audit })));
const Board = lazy(() => import('@/views/Board').then((m) => ({ default: m.Board })));
const Builds = lazy(() => import('@/views/Builds').then((m) => ({ default: m.Builds })));
const CodeReview = lazy(() =>
  import('@/views/CodeReview').then((m) => ({ default: m.CodeReview })),
);
const MrReviewSession = lazy(() =>
  import('@/views/ReviewSession').then((m) => ({ default: m.MrReviewSession })),
);
const CompareReviewSession = lazy(() =>
  import('@/views/ReviewSession').then((m) => ({ default: m.CompareReviewSession })),
);
const DeckView = lazy(() =>
  import('@/review/deck/DeckView').then((m) => ({ default: m.DeckView })),
);
const MrCreate = lazy(() => import('@/views/MrCreate').then((m) => ({ default: m.MrCreate })));
const TestBench = lazy(() => import('@/views/TestBench').then((m) => ({ default: m.TestBench })));
const Cockpit = lazy(() => import('@/views/Cockpit').then((m) => ({ default: m.Cockpit })));
const Kpi = lazy(() => import('@/views/Kpi').then((m) => ({ default: m.Kpi })));
const MrDetail = lazy(() => import('@/views/MrDetail').then((m) => ({ default: m.MrDetail })));
const MrInbox = lazy(() => import('@/views/MrInbox').then((m) => ({ default: m.MrInbox })));
const Notifications = lazy(() =>
  import('@/views/Notifications').then((m) => ({ default: m.Notifications })),
);
const Overview = lazy(() => import('@/views/Overview').then((m) => ({ default: m.Overview })));
const ReleaseTrain = lazy(() =>
  import('@/views/ReleaseTrain').then((m) => ({ default: m.ReleaseTrain })),
);
const SprintHarbor = lazy(() =>
  import('@/views/SprintHarbor').then((m) => ({ default: m.SprintHarbor })),
);
const Settings = lazy(() => import('@/views/Settings').then((m) => ({ default: m.Settings })));
const PostrackConnected = lazy(() =>
  import('@/views/PostrackConnected').then((m) => ({ default: m.PostrackConnected })),
);
const ReviewDesk = lazy(() =>
  import('@/views/ReviewDesk').then((m) => ({ default: m.ReviewDesk })),
);
const SyncHealth = lazy(() =>
  import('@/views/SyncHealth').then((m) => ({ default: m.SyncHealth })),
);

/** One boundary per route: the MR drawer loading inside the inbox must not blank the inbox. */
function page(View: LazyExoticComponent<ComponentType>) {
  return (
    <FeatureGate>
      <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
        <View />
      </Suspense>
    </FeatureGate>
  );
}

/** A drawer over its page: while its chunk loads, show nothing rather than a "Loading…" line under the page. */
function drawer(View: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense fallback={null}>
      <View />
    </Suspense>
  );
}

/** `/` is the Living Workspace itself (the scene draws it, nothing to render here); classic mode keeps Overview home. */
function HomeIndex() {
  const homeMode = useUiStore((s) => s.homeMode);
  return homeMode === 'scene' ? null : <Navigate to="/overview" replace />;
}

export const router = createBrowserRouter([
  // The Postrack sign-in popup's last page: no layout, it closes itself.
  {
    path: '/postrack/connected',
    element: (
      <Suspense fallback={null}>
        <PostrackConnected />
      </Suspense>
    ),
  },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomeIndex /> },
      { path: 'overview', element: page(Overview) },
      { path: 'notifications', element: page(Notifications) },
      { path: 'board', element: page(Board) },
      {
        path: 'mrs',
        element: page(MrInbox),
        children: [{ path: ':repo/:iid', element: drawer(MrDetail) }],
      },
      { path: 'review', element: page(CodeReview) },
      { path: 'reviews', element: page(ReviewDesk) },
      { path: 'review/:repo/mr/:iid', element: page(MrReviewSession) },
      { path: 'review/:repo/compare', element: page(CompareReviewSession) },
      { path: 'review/:source/:id/deck', element: page(DeckView) },
      { path: 'mr-create/:repo', element: page(MrCreate) },
      { path: 'test-bench/:repo', element: page(TestBench) },
      { path: 'cockpit', element: page(Cockpit) },
      { path: 'sync', element: page(SyncHealth) },
      { path: 'release', element: page(ReleaseTrain) },
      { path: 'builds', element: page(Builds) },
      { path: 'kpi', element: page(Kpi) },
      { path: 'sprints', element: page(SprintHarbor) },
      { path: 'settings', element: page(Settings) },
      { path: 'audit', element: page(Audit) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
