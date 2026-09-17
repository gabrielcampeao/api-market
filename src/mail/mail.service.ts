import { Injectable, Logger } from '@nestjs/common';
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  async sendPasswordReset(to: string, token: string): Promise<void> {
    this.log(
      to,
      'Password reset - Marketplace',
      `Use the token below to reset your password.\n\nToken: ${token}\n\nIt expires in 1 hour. If you did not request this, ignore this email.`,
    );
  }
  async sendOrderConfirmation(to: string, orderId: string, total: string): Promise<void> {
    this.log(
      to,
      `Order ${orderId} received - Marketplace`,
      `Thank you for your order!\n\nOrder: ${orderId}\nTotal: ${total}\n\nWe will notify you once your payment is approved.`,
    );
  }
  private log(to: string, subject: string, body: string): void {
    this.logger.log(`\n>>> [EMAIL] to=${to}\n>>> subject=${subject}\n>>> body=${body}\n`);
  }
}
