import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProductsModule } from '../products/products.module';
import { CartModule } from '../cart/cart.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import './enums';
import { AuthResolver } from './resolvers/auth.resolver';
import { UsersResolver } from './resolvers/users.resolver';
import { ProductsResolver } from './resolvers/products.resolver';
import { CartResolver } from './resolvers/cart.resolver';
import { OrdersResolver } from './resolvers/orders.resolver';
import { PaymentsResolver } from './resolvers/payments.resolver';

@Module({
  imports: [AuthModule, UsersModule, ProductsModule, CartModule, OrdersModule, PaymentsModule],
  providers: [
    AuthResolver,
    UsersResolver,
    ProductsResolver,
    CartResolver,
    OrdersResolver,
    PaymentsResolver,
  ],
})
export class GraphqlApiModule {}
