//! Numbers: `int` vs `float` results, `round`, float `//` and `%`, and number formatting.

use std::ops::{Add, Mul, Neg, Sub};

use serde_json::Value;

use super::{err, PyErr};

/// A Python number. `int` and `float` serialise differently, so the type rides along.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Num {
    Int(i64),
    Float(f64),
}

pub use Num::{Float, Int};

impl Num {
    pub fn f(self) -> f64 {
        match self {
            Int(i) => i as f64,
            Float(f) => f,
        }
    }

    /// A JSON number (or bool, which Python treats as an int).
    pub fn from_json(v: &Value) -> Option<Num> {
        match v {
            Value::Number(n) => Some(n.as_i64().map(Int).unwrap_or_else(|| Float(n.as_f64().unwrap_or(f64::NAN)))),
            Value::Bool(b) => Some(Int(*b as i64)),
            _ => None,
        }
    }

    pub fn json(self) -> Value {
        match self {
            Int(i) => Value::from(i),
            Float(f) => json_float(f),
        }
    }

    /// `a / b`: always a float.
    #[allow(clippy::should_implement_trait)]
    pub fn div(self, o: Num) -> Num {
        Float(self.f() / o.f())
    }

    /// `round(x, digits)`: an int stays an int.
    pub fn round(self, digits: i32) -> Num {
        match self {
            Int(i) => Int(i),
            Float(f) => Float(round_to(f, digits)),
        }
    }

    pub fn type_name(self) -> &'static str {
        match self {
            Int(_) => "int",
            Float(_) => "float",
        }
    }
}

fn int_op(a: i64, b: i64, op: fn(i64, i64) -> Option<i64>, fop: fn(f64, f64) -> f64) -> Num {
    op(a, b).map(Int).unwrap_or_else(|| Float(fop(a as f64, b as f64)))
}

impl Add for Num {
    type Output = Num;
    fn add(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_add, |x, y| x + y),
            _ => Float(self.f() + o.f()),
        }
    }
}

impl Sub for Num {
    type Output = Num;
    fn sub(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_sub, |x, y| x - y),
            _ => Float(self.f() - o.f()),
        }
    }
}

impl Mul for Num {
    type Output = Num;
    fn mul(self, o: Num) -> Num {
        match (self, o) {
            (Int(a), Int(b)) => int_op(a, b, i64::checked_mul, |x, y| x * y),
            _ => Float(self.f() * o.f()),
        }
    }
}

impl Neg for Num {
    type Output = Num;
    fn neg(self) -> Num {
        match self {
            Int(i) => Int(-i),
            Float(f) => Float(-f),
        }
    }
}

impl From<i64> for Num {
    fn from(i: i64) -> Num {
        Int(i)
    }
}

impl From<f64> for Num {
    fn from(f: f64) -> Num {
        Float(f)
    }
}

/// A float JSON value (`null` for NaN/inf, which JSON cannot carry).
pub fn json_float(f: f64) -> Value {
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// `round(x, digits)` for a float: correctly rounded, ties to even.
pub fn round_to(x: f64, digits: i32) -> f64 {
    if !x.is_finite() || digits > 323 {
        return x;
    }
    if digits < 0 {
        let p = 10f64.powi(-digits);
        return (x / p).round_ties_even() * p;
    }
    format!("{:.*}", digits as usize, x).parse().unwrap_or(x)
}

/// `round(x)`: ties to even, as an int.
pub fn round_int(x: f64) -> Result<i64, PyErr> {
    if x.is_nan() {
        return Err(err("cannot convert float NaN to integer"));
    }
    if x.is_infinite() {
        return Err(err("cannot convert float infinity to integer"));
    }
    Ok(x.round_ties_even() as i64)
}

/// [`round_int`] that saturates instead of raising (blueprint).
pub fn round_i64(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// `str(float)`.
pub fn float_str(f: f64) -> String {
    if f.is_nan() {
        "nan".into()
    } else if f.is_infinite() {
        if f > 0.0 { "inf" } else { "-inf" }.into()
    } else {
        crate::json::float_repr(f)
    }
}

/// `str(int(value))` for a finite float.
pub fn int_str(value: f64) -> String {
    let t = value.trunc();
    if t == 0.0 {
        return "0".into();
    }
    if t.abs() < 9.0e15 {
        return (t as i64).to_string();
    }
    format!("{:.0}", t)
}

/// `f"{n:,}"`.
pub fn thousands(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if n < 0 {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Python's float `divmod(a, b)` (CPython `float_divmod`).
pub fn divmod(a: f64, b: f64) -> (f64, f64) {
    let mut m = a % b;
    let mut div = (a - m) / b;
    if m != 0.0 {
        if (b < 0.0) != (m < 0.0) {
            m += b;
            div -= 1.0;
        }
    } else {
        m = 0.0_f64.copysign(b);
    }
    let floordiv = if div != 0.0 {
        let f = div.floor();
        if div - f > 0.5 {
            f + 1.0
        } else {
            f
        }
    } else {
        0.0_f64.copysign(a / b)
    };
    (floordiv, m)
}

/// `a // b` for floats.
pub fn floordiv(a: f64, b: f64) -> f64 {
    divmod(a, b).0
}

/// `a % b` for floats.
pub fn rem(a: f64, b: f64) -> f64 {
    divmod(a, b).1
}

/// `timedelta(seconds=x)` in microseconds, rounded the way CPython's `delta_new` does.
pub fn seconds_to_us(x: f64) -> i64 {
    let whole = x.trunc();
    let frac = x - whole;
    let mut us = whole as i64 * 1_000_000;
    if frac == 0.0 {
        return us;
    }
    let scaled = frac * 1e6;
    let scaled_whole = scaled.trunc();
    let leftover = scaled - scaled_whole;
    us += scaled_whole as i64;
    if leftover != 0.0 {
        let mut rounded = leftover.round();
        if (rounded - leftover).abs() == 0.5 {
            let odd = (us & 1) as f64;
            rounded = 2.0 * ((leftover + odd) * 0.5).round() - odd;
        }
        us += rounded as i64;
    }
    us
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_division_matches_python() {
        assert_eq!(divmod(7.5, 2.0), (3.0, 1.5));
        assert_eq!(divmod(-7.5, 2.0), (-4.0, 0.5));
        assert_eq!(rem(-1.0, 4.0), 3.0);
        assert_eq!(floordiv(-0.5, 604800.0), -1.0);
    }

    #[test]
    fn timedelta_seconds_rounding() {
        assert_eq!(seconds_to_us(1.5), 1_500_000);
        assert_eq!(seconds_to_us(0.0000005), 0);
        assert_eq!(seconds_to_us(0.0000015), 2);
        assert_eq!(seconds_to_us(1234.567891), 1_234_567_891);
        assert_eq!(seconds_to_us(0.0000025), 2);
        assert_eq!(seconds_to_us(10799.9999995), 10_799_999_999);
    }

    #[test]
    fn rounding_matches_python() {
        assert_eq!(round_to(2.675, 2), 2.67);
        assert_eq!(round_to(0.125, 2), 0.12);
        assert_eq!(round_to(0.375, 2), 0.38);
        assert_eq!(round_to(2.5, 0), 2.0);
        assert_eq!(round_to(2.0005, 3), 2.001);
        assert_eq!(round_to(0.1235, 3), 0.123);
        assert_eq!(round_int(2.5).unwrap(), 2);
        assert_eq!(round_int(3.5).unwrap(), 4);
        assert!(round_to(-0.001, 2).is_sign_negative());
        assert_eq!(round_i64(2.5), 2);
        assert_eq!(round_i64(-0.5), 0);
    }

    #[test]
    fn number_formats() {
        assert_eq!(int_str(-0.4), "0");
        assert_eq!(int_str(1e23), "99999999999999991611392");
        assert_eq!(format!("{:.1}", -0.04), "-0.0");
        assert_eq!(format!("{:.1}", 0.25), "0.2");
        assert_eq!(format!("{:.0}", 2.5), "2");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(thousands(999), "999");
    }
}
