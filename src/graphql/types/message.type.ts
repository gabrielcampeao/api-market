import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType('MessageResponse')
export class MessageResponse {
  @Field()
  message: string;

  // Only populated by forgotPassword outside production, for local testing
  // without a real mail provider — see AuthService.forgotPassword.
  @Field({ nullable: true })
  devResetToken?: string;
}
