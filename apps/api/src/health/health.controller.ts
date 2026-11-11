import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly db: DatabaseService) {}

  // GET /api/health: приложение живо и база отвечает.
  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    try {
      await this.db.query('select 1');
    } catch (error) {
      this.logger.error(`База не отвечает: ${(error as Error).message}`);
      throw new ServiceUnavailableException({
        error: 'database_unavailable',
        message: 'База данных недоступна',
      });
    }
    return { status: 'ok', database: 'up' };
  }
}
