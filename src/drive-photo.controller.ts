import { Controller, Get, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { GoogleWebAppClient } from './google-web-app.client';
import { getStorageInfo } from './storage-mode';

interface GooglePhoto {
  mimeType: string;
  base64: string;
}

@Controller('api/drive')
export class DrivePhotoController {
  constructor(private readonly google: GoogleWebAppClient) {}

  @Get(':fileId')
  async getPhoto(@Param('fileId') fileId: string): Promise<StreamableFile> {
    if (getStorageInfo().storage !== 'live') {
      throw new NotFoundException('등록된 사진이 없습니다.');
    }

    const photo = await this.google.call<GooglePhoto>('getPhoto', { id: fileId });
    return new StreamableFile(Buffer.from(photo.base64, 'base64'), { type: photo.mimeType });
  }
}