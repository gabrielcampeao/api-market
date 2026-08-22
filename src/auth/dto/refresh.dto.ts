import { ApiProperty } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';

@InputType()
export class RefreshDto {
  @ApiProperty({ description: 'Opaque refresh token issued at login/refresh' })
  @Field()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
