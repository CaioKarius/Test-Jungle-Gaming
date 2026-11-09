import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config/config';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { runWithContext } from './infrastructure/observability/request-context';
import { uuidv7 } from './shared/ids';

/** Assigns / propagates `X-Correlation-Id` and makes it ambient for logs. */
function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('x-correlation-id');
  const correlationId = header && header.length <= 128 ? header : uuidv7();
  res.setHeader('x-correlation-id', correlationId);
  runWithContext({ correlationId }, () => next());
}

/** Builds the Nest application (not listening). Shared by `main.ts` and the integration tests. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: new JsonLogger() });
  app.use(correlationMiddleware);
  // SIGTERM/SIGINT → onModuleDestroy (drain workers/consumer) → close HTTP → close DB pool.
  app.enableShutdownHooks();
  return app;
}
