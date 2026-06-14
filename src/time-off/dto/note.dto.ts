import { IsOptional, IsString, MaxLength } from 'class-validator';

export class NoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
