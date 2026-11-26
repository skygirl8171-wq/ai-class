import { Controller, Get } from '@nestjs/common';
import { getGeminiInfo, getStorageInfo } from './storage-mode';

@Controller('api/operations')
export class OperationsController {
  @Get()
  getOperations() {
    return { ...getStorageInfo(), ...getGeminiInfo() };
  }
}
