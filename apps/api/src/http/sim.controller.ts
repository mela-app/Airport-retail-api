/**
 * Simulation control bar: play, pause, speed, jump to time, reset, and "inject event" buttons.
 */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodBody } from '../core/openapi.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { localToUtc } from '@arm/domain';
import { calendarDay } from '@arm/mockgen';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import { CONFIG, SIMULATION } from '../core/tokens.js';
import { parseInput } from '../core/http.js';
import type { Simulation } from '../sim/simulation.js';

const SpeedBody = z.object({ speed: z.number().min(0.25).max(120) });
const JumpBody = z.union([
  z.object({ to: z.iso.datetime({ offset: true }) }),
  z.object({ localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
]);
const DelayBody = z.object({
  flightId: z.string().min(1).max(40),
  minutes: z.number().int().min(1).max(600),
  delayCode: z
    .string()
    .regex(/^\d{2}$/)
    .default('93'),
});
const GateBody = z.object({ flightId: z.string().min(1).max(40), gate: z.string().regex(/^[A-Z0-9]{1,5}$/) });
const ScreenBody = z.object({ screenId: z.string().min(1).max(40) });

@ApiTags('Simulation')
@Controller('api/sim')
export class SimController {
  constructor(
    @Inject(SIMULATION) private readonly sim: Simulation,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @ApiOperation({ summary: 'Simulation state: clock, airport, day, adapters in use' })
  @Get()
  state() {
    const cal = calendarDay(this.config.SIM_DATE);
    return {
      clock: this.sim.clock.state(),
      airport: {
        code: this.config.HOME_AIRPORT,
        utcOffsetMinutes: this.config.AIRPORT_UTC_OFFSET_MINUTES,
        currency: this.config.CURRENCY,
      },
      day: { date: cal.date, festival: cal.festival, schoolHoliday: cal.schoolHoliday },
      startTime: this.sim.startTime().toISOString(),
      injection: { flights: Boolean(this.sim.sources.flights.inject), screens: true },
      adapters: {
        flights: this.sim.sources.flights.adapter,
        space: this.sim.sources.space.adapter,
        audience: this.sim.sources.audience.adapter,
      },
    };
  }

  @ApiOperation({ summary: 'Play the simulation clock' })
  @Post('play')
  @HttpCode(200)
  play() {
    this.sim.clock.play();
    return this.sim.clock.state();
  }

  @ApiOperation({ summary: 'Pause the simulation clock' })
  @Post('pause')
  @HttpCode(200)
  pause() {
    this.sim.clock.pause();
    return this.sim.clock.state();
  }

  @ApiOperation({ summary: 'Set the simulation speed (e.g. 1x, 10x, 60x)' })
  @ZodBody(SpeedBody)
  @Post('speed')
  @HttpCode(200)
  speed(@Body() body: unknown) {
    this.sim.clock.setSpeed(parseInput(SpeedBody, body).speed);
    return this.sim.clock.state();
  }

  @ApiOperation({
    summary: 'Jump to a time (local `HH:MM` or an ISO instant); jumping back rewinds recorded data',
  })
  @ZodBody(JumpBody)
  @Post('jump')
  @HttpCode(200)
  async jump(@Body() body: unknown) {
    const input = parseInput(JumpBody, body);
    const target =
      'to' in input
        ? new Date(input.to)
        : localToUtc(
            this.config.SIM_DATE,
            Number(input.localTime.slice(0, 2)),
            Number(input.localTime.slice(3, 5)),
            this.config.AIRPORT_UTC_OFFSET_MINUTES,
          );
    this.sim.clock.jump(target);
    await this.sim.settled();
    return this.sim.clock.state();
  }

  @ApiOperation({ summary: 'Reset to the configured start time and speed' })
  @Post('reset')
  @HttpCode(200)
  async reset() {
    await this.sim.reset();
    return this.sim.clock.state();
  }

  @ApiOperation({ summary: 'Inject an AIDX delay for a flight (goes through the AIDX adapter)' })
  @ZodBody(DelayBody)
  @Post('inject/delay')
  @HttpCode(200)
  async delay(@Body() body: unknown) {
    const input = parseInput(DelayBody, body);
    const { event, xml } = this.sim.injectors.delay(
      input.flightId,
      input.minutes,
      input.delayCode,
      this.sim.clock.now(),
    );
    await this.sim.settleInjection(event.id);
    this.sim.bus.publish('sim', {
      action: 'inject_delay',
      detail: { flightId: input.flightId, minutes: input.minutes },
      at: event.occurredAt,
    });
    return { event, aidxMessage: xml };
  }

  @ApiOperation({ summary: 'Inject an AIDX gate change for a departure' })
  @ZodBody(GateBody)
  @Post('inject/gate-change')
  @HttpCode(200)
  async gateChange(@Body() body: unknown) {
    const input = parseInput(GateBody, body);
    const { event, xml } = this.sim.injectors.changeGate(input.flightId, input.gate, this.sim.clock.now());
    await this.sim.settleInjection(event.id);
    this.sim.bus.publish('sim', {
      action: 'inject_gate_change',
      detail: { flightId: input.flightId, gate: input.gate },
      at: event.occurredAt,
    });
    return { event, aidxMessage: xml };
  }

  @ApiOperation({ summary: 'Take a screen offline (raises an incident after 5 simulated minutes)' })
  @ZodBody(ScreenBody)
  @Post('inject/screen-offline')
  @HttpCode(200)
  async screenOffline(@Body() body: unknown) {
    const { screenId } = parseInput(ScreenBody, body);
    const screen = await this.sim.fleet.forceOffline(screenId, this.sim.clock.now());
    await this.sim.engine.replanNow({ screenIds: [screenId] });
    this.sim.bus.publish('sim', {
      action: 'inject_screen_offline',
      detail: { screenId },
      at: this.sim.clock.now().toISOString(),
    });
    return screen;
  }

  @ApiOperation({ summary: 'Bring a screen back online' })
  @ZodBody(ScreenBody)
  @Post('inject/screen-online')
  @HttpCode(200)
  async screenOnline(@Body() body: unknown) {
    const { screenId } = parseInput(ScreenBody, body);
    const screen = await this.sim.fleet.restore(screenId, this.sim.clock.now());
    await this.sim.engine.replanNow({ screenIds: [screenId] });
    this.sim.bus.publish('sim', {
      action: 'inject_screen_online',
      detail: { screenId },
      at: this.sim.clock.now().toISOString(),
    });
    return screen;
  }
}
