import { Field, ObjectType } from '@nestjs/graphql';
@ObjectType('MessageResponse')
export class MessageResponse {
  @Field()
  message: string;
  @Field({ nullable: true })
  devResetToken?: string;
}
