import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class LoginDto {
  @ApiProperty({ example: 'jane@example.com' })
  @Field()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'S3curePass!' })
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;
}
