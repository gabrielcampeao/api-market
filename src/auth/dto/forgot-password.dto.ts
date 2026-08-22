import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';

@InputType()
export class ForgotPasswordDto {
  @ApiProperty({ example: 'jane@example.com' })
  @Field()
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email: string;
}
