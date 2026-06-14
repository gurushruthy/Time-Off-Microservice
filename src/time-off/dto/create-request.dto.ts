import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'isHalfDayMultiple', async: false })
export class IsHalfDayMultiple implements ValidatorConstraintInterface {
  validate(value: number, _args: ValidationArguments) {
    return typeof value === 'number' && value > 0 && value % 0.5 === 0;
  }
  defaultMessage(_args: ValidationArguments) {
    return 'daysRequested must be a positive multiple of 0.5';
  }
}

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber()
  @Min(0.5)
  @Validate(IsHalfDayMultiple)
  daysRequested: number;
}
