import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

@InputType()
export class RegisterDto {
  @ApiProperty({ example: 'jane@example.com' })
  @Field()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'S3curePass!', minLength: 8, maxLength: 72 })
  @Field()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
