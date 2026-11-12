import { Cover } from '@/overview/Cover';
import { FrontPage } from '@/overview/FrontPage';
import { useOverviewData } from '@/overview/useOverviewData';
import { usePresentation } from '@/workspace/presentation';

/**
 * Overview: one set of numbers (useOverviewData), two printings. In the Living Workspace it is a magazine
 * cover over the crystal; in Classic it is the day's front page.
 */
export function Overview() {
  const data = useOverviewData();
  return usePresentation() === 'world' ? <Cover data={data} /> : <FrontPage data={data} />;
}
