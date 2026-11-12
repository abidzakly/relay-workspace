import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import type { NextJob } from './nextJob';

/** One job and one way to it. It only navigates: anything that writes stays behind its own page and dialog. */
export function NextJobCard({ job }: { job: NextJob }) {
  return (
    <section aria-label="Next job" className="flex flex-col gap-2 border-t border-foreground pt-3">
      <p className="type-micro">(→) Next job</p>
      <p
        className="line-clamp-2 text-xl leading-tight font-semibold tracking-[-0.03em]"
        title={job.row.title}
      >
        {job.row.title}
      </p>
      <p className="line-clamp-2 text-sm text-muted-foreground">{job.row.detail}</p>
      <Button asChild size="sm" className="mt-1 self-start">
        <Link to={job.row.to}>
          {job.cta}
          <ArrowRight />
        </Link>
      </Button>
    </section>
  );
}
