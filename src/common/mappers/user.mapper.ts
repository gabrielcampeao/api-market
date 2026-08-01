import { User } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Role } from '@prisma/client';

@ObjectType('User')
export class UserDto {
  @ApiProperty({ format: 'uuid' })
  @Field(() => ID)
  id: string;

  @ApiProperty({ example: 'user@example.com' })
  @Field()
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  @Field()
  name: string;

  @ApiProperty({ enum: Role, example: Role.USER })
  @Field(() => Role)
  role: Role;

  @ApiProperty({ example: true })
  @Field()
  isActive: boolean;

  @ApiProperty()
  @Field()
  createdAt: Date;

  @ApiProperty()
  @Field()
  updatedAt: Date;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
