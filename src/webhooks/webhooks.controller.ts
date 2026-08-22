import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { StripeWebhookService } from './stripe-webhook.service';

// Excluded from Swagger and unauthenticated by design (@Public()) — Stripe
// calls this directly, with no bearer token and no interest in API docs.
// Trust is established by signature verification inside the service, not by
// anything at this layer.
@ApiExcludeController()
@Controller('webhooks')
@SkipThrottle({ default: true, auth: true })
export class WebhooksController {
  constructor(private readonly stripeWebhooks: StripeWebhookService) {}

  @Public()
  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ status: string }> {
    return this.stripeWebhooks.handleEvent(req.rawBody, signature);
  }
}
