import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { ProductsService } from './products.service';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated-response.decorator';
import { getRequestContext } from '../common/utils/request-context.util';
import { AuthenticatedUser } from '../auth/interfaces/auth.types';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { ProductDto, toProductDto } from './dto/product.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';

@ApiTags('products')
@Controller('products')
@SkipThrottle({ auth: true })
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List active products with pagination and filters' })
  @ApiPaginatedResponse(ProductDto)
  findAll(@Query() query: QueryProductsDto): Promise<PaginatedResponseDto<ProductDto>> {
    return this.productsService.findAll(query);
  }

  @ApiBearerAuth()
  @Get('admin/all')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all products including inactive (admin)' })
  @ApiPaginatedResponse(ProductDto)
  findAllAdmin(
    @Query() query: QueryProductsDto,
  ): Promise<PaginatedResponseDto<ProductDto>> {
    return this.productsService.findAll(query, true);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get a product by id' })
  @ApiOkResponse({ type: ProductDto })
  async findOne(@Param('id') id: string): Promise<ProductDto> {
    const product = await this.productsService.findById(id, true);
    return toProductDto(product);
  }

  @ApiBearerAuth()
  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product (admin)' })
  @ApiCreatedResponse({ type: ProductDto })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateProductDto,
    @Req() req: Request,
  ): Promise<ProductDto> {
    return this.productsService.create(admin.id, dto, getRequestContext(req));
  }

  @ApiBearerAuth()
  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product (admin)' })
  @ApiOkResponse({ type: ProductDto })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: Request,
  ): Promise<ProductDto> {
    return this.productsService.update(admin.id, id, dto, getRequestContext(req));
  }

  @ApiBearerAuth()
  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Soft delete a product (admin)' })
  @ApiOkResponse({ description: 'Product deactivated' })
  deactivate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.productsService.softDelete(admin.id, id, getRequestContext(req));
  }
}
