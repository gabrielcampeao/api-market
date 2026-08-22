import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Context } from '@nestjs/graphql';
import { Request } from 'express';
import { AuthService } from '../../auth/auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRequestContext } from '../../common/utils/request-context.util';
import { toUserDto, UserDto } from '../../common/mappers/user.mapper';
import { AuthenticatedUser } from '../../auth/interfaces/auth.types';
import { RegisterDto } from '../../auth/dto/register.dto';
import { LoginDto } from '../../auth/dto/login.dto';
import { RefreshDto } from '../../auth/dto/refresh.dto';
import { ForgotPasswordDto } from '../../auth/dto/forgot-password.dto';
import { ResetPasswordDto } from '../../auth/dto/reset-password.dto';
import { TokenResponseDto } from '../../auth/dto/token-response.dto';
import { MessageResponse } from '../types/message.type';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Mutation(() => TokenResponseDto)
  async register(
    @Args('input') dto: RegisterDto,
    @Context('req') req: Request,
  ): Promise<TokenResponseDto> {
    return this.authService.register(dto, getRequestContext(req));
  }

  @Public()
  @Mutation(() => TokenResponseDto)
  async login(
    @Args('input') dto: LoginDto,
    @Context('req') req: Request,
  ): Promise<TokenResponseDto> {
    return this.authService.login(dto, getRequestContext(req));
  }

  @Public()
  @Mutation(() => TokenResponseDto)
  async refreshToken(
    @Args('input') dto: RefreshDto,
    @Context('req') req: Request,
  ): Promise<TokenResponseDto> {
    return this.authService.refresh(dto, getRequestContext(req));
  }

  @Mutation(() => MessageResponse)
  async logout(
    @Args('input') dto: RefreshDto,
    @CurrentUser() user: AuthenticatedUser,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.authService.logout(dto, user.id, getRequestContext(req));
  }

  @Public()
  @Mutation(() => MessageResponse)
  async forgotPassword(
    @Args('input') dto: ForgotPasswordDto,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.authService.forgotPassword(dto, getRequestContext(req));
  }

  @Public()
  @Mutation(() => MessageResponse)
  async resetPassword(
    @Args('input') dto: ResetPasswordDto,
    @Context('req') req: Request,
  ): Promise<MessageResponse> {
    return this.authService.resetPassword(dto, getRequestContext(req));
  }

  @Query(() => UserDto)
  async profile(@CurrentUser() user: AuthenticatedUser): Promise<UserDto> {
    const full = await this.authService.getProfile(user.id);
    return toUserDto(full);
  }
}
