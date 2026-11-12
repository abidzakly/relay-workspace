import type { BuildResult, Job } from '@relay/shared';
import { ActionError } from './actionError';

/**
 * HARD RULE: only a staging build may reach Drive or QA. Prod is never shared, and `custom` is not staging.
 * It reads nothing but the job and its build result, so no setting or request can change the answer. `DriveService` and
 * `ShareService` each apply it. Anything unexpected in the result counts as not staging.
 */
export function isStagingOnly(job: Pick<Job, 'mode'>, result: BuildResult): boolean {
  return (
    job.mode === 'staging' &&
    result.mode === 'staging' &&
    result.buildMode === 'staging' &&
    result.flavor !== 'production' &&
    result.artifacts.every((artifact) => artifact.kind === 'apk')
  );
}

export function assertStagingOnly(job: Pick<Job, 'mode'>, result: BuildResult): void {
  if (!isStagingOnly(job, result)) {
    throw new ActionError(
      403,
      'prod_never_shared',
      'Only staging builds can be uploaded or shared. Prod and custom builds never are.',
    );
  }
}
