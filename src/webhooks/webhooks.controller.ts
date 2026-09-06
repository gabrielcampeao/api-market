import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { StripeWebhookService } from './stripe-webhook.service';
@ApiExcludeController()
@Controller('webhooks')
@SkipThrottle({ default: true, auth: true })
export class WebhooksController {
  constructor(private readonly stripeWebhooks: StripeWebhookService) {}
  @Public()
  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req()
    req: RawBodyRequest<Request>,
    @Headers('stripe-signature')
    signature: string | undefined,
  ): Promise<{
    status: string;
  }> {
    return this.stripeWebhooks.handleEvent(req.rawBody, signature);
  }
}
