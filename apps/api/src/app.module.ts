import { type DynamicModule, Module } from '@nestjs/common';

import type { AppConfig } from './config.js';
import { CoreModule } from './core/core.module.js';
import { AnalyticsController } from './http/analytics.controller.js';
import { AssistantController } from './http/assistant.controller.js';
import { ClaimsController } from './http/claims.controller.js';
import { EngineController } from './http/engine.controller.js';
import { MasterDataController } from './http/master-data.controller.js';
import { OperationsController } from './http/operations.controller.js';
import { SimController } from './http/sim.controller.js';
import { StreamController } from './http/stream.controller.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config)],
      controllers: [
        SimController,
        OperationsController,
        EngineController,
        MasterDataController,
        ClaimsController,
        AnalyticsController,
        AssistantController,
        StreamController,
      ],
    };
  }
}
