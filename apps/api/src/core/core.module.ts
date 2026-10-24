/**
 * Wires the framework-independent core (config, database, bus, clock, sources, simulation) into NestJS.
 */
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { count } from 'drizzle-orm';

import { createSources } from '../adapters/registry.js';
import type { AppConfig } from '../config.js';
import { type Database, createDatabase } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import * as t from '../db/schema.js';
import { seed } from '../db/seed.js';
import { EventBus } from '../sim/event-bus.js';
import { SimClock } from '../sim/sim-clock.js';
import { Simulation } from '../sim/simulation.js';
import { BUS, CLOCK, CONFIG, DATABASE, SIMULATION, SOURCES } from './tokens.js';

/** Open the database, apply migrations, and seed it when it is empty. */
export async function openDatabase(config: AppConfig, logger = new Logger('Database')): Promise<Database> {
  const database = createDatabase(config.DATABASE_URL);
  const applied = await migrate(database);
  if (applied.length > 0) logger.log(`Applied migrations: ${applied.join(', ')}`);
  const [row] = await database.db.select({ n: count() }).from(t.campaigns);
  if ((row?.n ?? 0) === 0) {
    const counts = await seed(database, {
      simDate: config.SIM_DATE,
      seed: config.SIM_SEED,
      utcOffsetMinutes: config.AIRPORT_UTC_OFFSET_MINUTES,
      currency: config.CURRENCY,
    });
    logger.log(`Seeded an empty database: ${JSON.stringify(counts)}`);
  }
  return database;
}

@Injectable()
class SimulationLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Simulation');

  constructor(
    @Inject(SIMULATION) private readonly simulation: Simulation,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.simulation.start();
    const s = this.simulation.clock.state();
    this.logger.log(`Simulation running at ${s.now} (${s.playing ? `playing ${s.speed}x` : 'paused'})`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.simulation.stop();
    await this.database.close();
  }
}

@Global()
@Module({})
export class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DATABASE, useFactory: () => openDatabase(config) },
        { provide: BUS, useValue: new EventBus() },
        {
          provide: CLOCK,
          useFactory: () => {
            const { start, bounds } = Simulation.clockSettings(config);
            return new SimClock({ start, bounds, speed: config.SIM_SPEED, playing: config.SIM_AUTOPLAY });
          },
        },
        { provide: SOURCES, useFactory: (clock: SimClock) => createSources(config, clock), inject: [CLOCK] },
        {
          provide: SIMULATION,
          useFactory: (
            database: Database,
            sources: ReturnType<typeof createSources>,
            bus: EventBus,
            clock: SimClock,
          ) => new Simulation(config, database, sources, bus, clock, new Logger('Simulation')),
          inject: [DATABASE, SOURCES, BUS, CLOCK],
        },
        SimulationLifecycle,
      ],
      exports: [CONFIG, DATABASE, BUS, CLOCK, SOURCES, SIMULATION],
    };
  }
}
