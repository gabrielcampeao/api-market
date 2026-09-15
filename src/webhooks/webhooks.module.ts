import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { StripeWebhookService } from './stripe-webhook.service';

@Module({
  controllers: [WebhooksController],
  providers: [StripeWebhookService],
})
export class WebhooksModule {}
