import type { FastifyInstance } from 'fastify';
import type { GamificationService } from '../../services/gamificationService';

/** GET /api/gamification: XP, level, streaks, badges and release history. Read-only. */
export function registerGamificationRoutes(
  app: FastifyInstance,
  deps: { gamification: GamificationService },
): void {
  app.get('/api/gamification', async () => deps.gamification.report());
}
