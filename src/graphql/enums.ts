import { registerEnumType } from '@nestjs/graphql';
import { OrderStatus, PaymentStatus, Role } from '@prisma/client';

registerEnumType(Role, { name: 'Role' });
registerEnumType(OrderStatus, { name: 'OrderStatus' });
registerEnumType(PaymentStatus, { name: 'PaymentStatus' });
