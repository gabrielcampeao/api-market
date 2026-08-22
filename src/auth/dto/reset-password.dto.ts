import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

@InputType()
export class ResetPasswordDto {
  @ApiProperty({ description: 'Token received by email' })
  @Field()
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'NewS3curePass!', minLength: 8, maxLength: 72 })
  @Field()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword: string;
}
