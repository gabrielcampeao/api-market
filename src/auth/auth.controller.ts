import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { toUserDto, UserDto } from '../common/mappers/user.mapper';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from './interfaces/auth.types';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TokenResponseDto } from './dto/token-response.dto';

const AUTH_THROTTLE_LIMIT = Number(process.env.THROTTLE_AUTH_LIMIT) || 20;
const AUTH_THROTTLE_TTL_MS = Number(process.env.THROTTLE_TTL_MS) || 60_000;

@ApiTags('auth')
@Controller('auth')
@Throttle({ auth: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user account' })
  @ApiCreatedResponse({ type: TokenResponseDto })
  register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<TokenResponseDto> {
    return this.authService.register(dto, getRequestContext(req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login and receive an access + refresh token pair' })
  @ApiOkResponse({ type: TokenResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenResponseDto> {
    return this.authService.login(dto, getRequestContext(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token into a fresh token pair' })
  @ApiOkResponse({ type: TokenResponseDto })
  refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
  ): Promise<TokenResponseDto> {
    return this.authService.refresh(dto, getRequestContext(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the provided refresh token' })
  @ApiOkResponse({ description: 'Logged out' })
  logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    return this.authService.logout(dto, user.id, getRequestContext(req));
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset token (sent by email)' })
  @ApiOkResponse({ description: 'Generic confirmation to prevent user enumeration' })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string; devResetToken?: string }> {
    return this.authService.forgotPassword(dto, getRequestContext(req));
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset the password using the emailed token' })
  @ApiOkResponse({ description: 'Password updated' })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.authService.resetPassword(dto, getRequestContext(req));
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the currently authenticated user' })
  @ApiOkResponse({ type: UserDto })
  async profile(@CurrentUser() user: AuthenticatedUser): Promise<UserDto> {
    const full = await this.authService.getProfile(user.id);
    return toUserDto(full);
  }
}
