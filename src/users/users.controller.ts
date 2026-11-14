import { Body, Controller, Delete, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { UsersService } from './users.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated-response.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { toUserDto, UserDto } from '../common/mappers/user.mapper';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { UpdateMeDto } from './dto/update-me.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@SkipThrottle({ auth: true })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiOkResponse({ type: UserDto })
  async getMe(@CurrentUser() user: AuthenticatedUser): Promise<UserDto> {
    const full = await this.usersService.findById(user.id);
    return toUserDto(full);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update own profile (name and/or password)' })
  @ApiOkResponse({ type: UserDto })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
    @Req() req: Request,
  ): Promise<UserDto> {
    const updated = await this.usersService.updateMe(user.id, dto, getRequestContext(req));
    return toUserDto(updated);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List users with pagination and filters (admin)' })
  @ApiPaginatedResponse(UserDto)
  findAll(@Query() query: QueryUsersDto): Promise<PaginatedResponseDto<UserDto>> {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get a user by id (admin)' })
  @ApiOkResponse({ type: UserDto })
  async findOne(@Param('id') id: string): Promise<UserDto> {
    const user = await this.usersService.findById(id);
    return toUserDto(user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a user (admin): name, role, active status' })
  @ApiOkResponse({ type: UserDto })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ): Promise<UserDto> {
    return this.usersService.update(admin.id, id, dto, getRequestContext(req));
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Deactivate a user (admin)' })
  @ApiOkResponse({ description: 'User deactivated' })
  deactivate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.usersService.deactivate(admin.id, id, getRequestContext(req));
  }
}
