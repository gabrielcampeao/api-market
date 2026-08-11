import { Args, Context, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { toUserDto, UserDto } from '../../common/mappers/user.mapper';
import { UpdateMeDto } from '../../users/dto/update-me.dto';
import { UpdateUserDto } from '../../users/dto/update-user.dto';
import { QueryUsersDto } from '../../users/dto/query-users.dto';
import { MessageResponse } from '../types/message.type';
import { Paginated } from '../paginated.type';

@ObjectType()
export class PaginatedUsersDto extends Paginated(UserDto) {}

@Resolver(() => UserDto)
export class UsersResolver {
  constructor(private readonly usersService: UsersService) {}

  @Query(() => UserDto)
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserDto> {
    const full = await this.usersService.findById(user.id);
    return toUserDto(full);
  }

  @Mutation(() => UserDto)
  async updateMe(
    @Args('input') dto: UpdateMeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<UserDto> {
    const updated = await this.usersService.updateMe(user.id, dto, getRequestContext(req));
    return toUserDto(updated);
  }

  @Roles(Role.ADMIN)
  @Query(() => PaginatedUsersDto)
  users(@Args('query', { nullable: true }) query: QueryUsersDto = new QueryUsersDto()) {
    return this.usersService.findAll(query);
  }

  @Roles(Role.ADMIN)
  @Query(() => UserDto)
  async user(@Args('id', { type: () => ID }) id: string): Promise<UserDto> {
    const found = await this.usersService.findById(id);
    return toUserDto(found);
  }

  @Roles(Role.ADMIN)
  @Mutation(() => UserDto)
  async updateUser(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') dto: UpdateUserDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<UserDto> {
    return this.usersService.update(admin.id, id, dto, getRequestContext(req));
  }

  @Roles(Role.ADMIN)
  @Mutation(() => MessageResponse)
  deactivateUser(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.usersService.deactivate(admin.id, id, getRequestContext(req));
  }
}
