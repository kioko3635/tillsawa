const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export function assertMinorUnits(value: bigint | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Posted money amounts must be safe integer minor units');
    return BigInt(value);
  }
  return value;
}

export function minorUnitsToDatabase(value: bigint | number): string {
  return assertMinorUnits(value).toString();
}

export function minorUnitsToDecimal(value: bigint | number | string): string {
  const minor = assertMinorUnits(typeof value === 'string' ? BigInt(value) : value);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function decimalToMinorUnits(value: string): bigint {
  return decimalToScaledInt(value, 2);
}

export function percentToBasisPoints(value: string): bigint {
  return decimalToScaledInt(value, 2);
}

export function decimalToScaledInt(value: string, scale = 6): bigint {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match || scale < 0 || !Number.isSafeInteger(scale)) {
    throw new Error('Decimal values must use an exact, non-exponent string representation');
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) throw new Error(`Decimal value exceeds scale ${scale}`);
  const scaled = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  return sign === '-' ? -scaled : scaled;
}

export function scaledIntToDecimal(value: bigint, scale = 6): string {
  if (scale < 0 || !Number.isSafeInteger(scale)) throw new Error('Scale must be a non-negative safe integer');
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function addScaled(left: bigint, right: bigint): bigint {
  return left + right;
}

export function multiplyScaled(left: bigint, right: bigint, resultScale = 6, operandScale = 6): bigint {
  const product = left * right;
  const divisor = 10n ** BigInt(Math.max(0, operandScale * 2 - resultScale));
  const half = divisor / 2n;
  return product >= 0n ? (product + half) / divisor : (product - half) / divisor;
}

export function quantityToScaledInt(value: string): bigint {
  return decimalToScaledInt(value, 6);
}

export function multiplyMinorByQuantity(amountMinor: bigint | number | string, quantity: string): bigint {
  const amount = assertMinorUnits(typeof amountMinor === 'string' ? BigInt(amountMinor) : amountMinor);
  const scaledQuantity = quantityToScaledInt(quantity);
  const divisor = 1_000_000n;
  const product = amount * scaledQuantity;
  const half = divisor / 2n;
  return product >= 0n ? (product + half) / divisor : (product - half) / divisor;
}

export function basisPointsOfMinor(amountMinor: bigint | number | string, basisPoints: bigint | number | string): bigint {
  const amount = assertMinorUnits(typeof amountMinor === 'string' ? BigInt(amountMinor) : amountMinor);
  const bps = typeof basisPoints === 'string' ? BigInt(basisPoints) : BigInt(basisPoints);
  const product = amount * bps;
  const half = 5_000n;
  return product >= 0n ? (product + half) / 10_000n : (product - half) / 10_000n;
}

export function inclusiveTaxFromMinor(totalMinor: bigint | number | string, basisPoints: bigint | number | string): bigint {
  const total = assertMinorUnits(typeof totalMinor === 'string' ? BigInt(totalMinor) : totalMinor);
  const bps = typeof basisPoints === 'string' ? BigInt(basisPoints) : BigInt(basisPoints);
  const denominator = 10_000n + bps;
  if (denominator <= 0n) return 0n;
  const product = total * bps;
  const half = denominator / 2n;
  return product >= 0n ? (product + half) / denominator : (product - half) / denominator;
}

export function proportionalMinor(totalMinor: bigint | number | string, partQuantity: string, wholeQuantity: string): bigint {
  const total = assertMinorUnits(typeof totalMinor === 'string' ? BigInt(totalMinor) : totalMinor);
  const numerator = quantityToScaledInt(partQuantity);
  const denominator = quantityToScaledInt(wholeQuantity);
  if (denominator === 0n) throw new Error('Cannot calculate a proportion of a zero quantity');
  const product = total * numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const half = absoluteDenominator / 2n;
  return product >= 0n ? (product + half) / denominator : (product - half) / denominator;
}
