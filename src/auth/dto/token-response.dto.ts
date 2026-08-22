import { ApiProperty } from '@nestjs/swagger';
import { Field, ObjectType } from '@nestjs/graphql';
import { TokenPair } from '../interfaces/auth.types';

@ObjectType('TokenPair')
export class TokenResponseDto implements TokenPair {
  @ApiProperty({ description: 'Short-lived JWT access token' })
  @Field()
  accessToken: string;

  @ApiProperty({ description: 'Opaque refresh token, rotate on each use' })
  @Field()
  refreshToken: string;

  @ApiProperty({ example: 'Bearer' })
  @Field()
  tokenType?: string = 'Bearer';
}
