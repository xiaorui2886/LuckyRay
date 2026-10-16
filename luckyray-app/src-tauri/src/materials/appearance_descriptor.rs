//! Deterministic local pixel appearance. No model, semantic claim, network or source mutation.
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

pub(super) const ALGORITHM: &str = "pixel-appearance-v1";
pub(super) const MAX_BYTES: usize = 12 * 1024 * 1024;
pub(super) const MAX_PIXELS: u64 = 20_000_000;
pub(super) const MAX_SIDE: u32 = 8192;
pub(super) const MAX_CANDIDATES: usize = 96;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Descriptor {
    pub width: u32,
    pub height: u32,
    pub spatial: Vec<u8>,
    pub histogram: Vec<u16>,
    pub edges: Vec<bool>,
}
impl Descriptor {
    pub(super) fn valid(&self) -> bool {
        self.width > 0 && self.height > 0 && self.width <= MAX_SIDE && self.height <= MAX_SIDE
            && u64::from(self.width) * u64::from(self.height) <= MAX_PIXELS
            && self.spatial.len() == 192 && self.histogram.len() == 64 && self.edges.len() == 64
            && self.histogram.iter().map(|&n| u32::from(n)).sum::<u32>() == 1024
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Distance {
    pub total: f64,
    pub spatial: f64,
    pub color: f64,
    pub structure: f64,
    pub proportion: f64,
}
pub(super) fn distance(a: &Descriptor, b: &Descriptor) -> Distance {
    let spatial = a.spatial.iter().zip(&b.spatial).map(|(&a, &b)| f64::from(a.abs_diff(b))).sum::<f64>() / (192.0 * 255.0);
    let color = a.histogram.iter().zip(&b.histogram).map(|(&a, &b)| f64::from(a.abs_diff(b))).sum::<f64>() / 2048.0;
    let structure = a.edges.iter().zip(&b.edges).filter(|(a,b)| a != b).count() as f64 / 64.0;
    let proportion = ((f64::from(a.width) / f64::from(a.height)).ln()
        - (f64::from(b.width) / f64::from(b.height)).ln()).abs().min(4.0) / 4.0;
    Distance { total: 0.5 * spatial + 0.25 * color + 0.2 * structure + 0.05 * proportion,
        spatial, color, structure, proportion }
}

pub(super) fn describe(bytes: &[u8]) -> Result<Descriptor, String> {
    describe_with_edge_threshold(bytes, 8_000)
}
fn describe_with_edge_threshold(bytes: &[u8], edge_threshold: u32) -> Result<Descriptor, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err("图片为空或超过12MiB".into()); }
    let format = image::guess_format(bytes).map_err(|_| "无法识别图片格式")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE); limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(96 * 1024 * 1024);
    // Animation detection uses the actual bitstream, never a filename or MIME claim.
    match format {
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes),limits.clone()).map_err(|_| "PNG损坏或不可解码")?;
            if decoder.is_apng().map_err(|_| "PNG动画标记无效")? { return Err("本轮不支持APNG动画".into()); }
        }
        ImageFormat::WebP => {
            let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|_| "WebP损坏或不可解码")?;
            if decoder.has_animation() { return Err("本轮不支持WebP动画".into()); }
        }
        ImageFormat::Jpeg | ImageFormat::Bmp => {}
        _ => return Err("仅支持JPEG、PNG、BMP和静态WebP；不支持GIF、动画或其他媒体".into()),
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| "图片损坏或超过解码资源上限")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("图片超过2000万像素或尺寸无效".into());
    }
    let orientation = decoder.orientation().map_err(|_| "图片方向信息无效")?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "图片损坏或不可解码")?;
    image.apply_orientation(orientation);
    let rgba = image.into_rgba8();
    let (width, height) = rgba.dimensions();
    let white = RgbImage::from_fn(width, height, |x, y| {
        let p = rgba.get_pixel(x, y); let alpha = u16::from(p[3]);
        Rgb(std::array::from_fn(|i| ((u16::from(p[i]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8))
    });
    let small = image::imageops::resize(&white, 32, 32, image::imageops::FilterType::Triangle);
    let spatial = image::imageops::resize(&small, 8, 8, image::imageops::FilterType::Triangle).into_raw();
    let mut histogram = vec![0u16; 64];
    for p in small.pixels() { histogram[usize::from(p[0] / 64) * 16 + usize::from(p[1] / 64) * 4 + usize::from(p[2] / 64)] += 1; }
    let edge_image = image::imageops::resize(&small, 9, 8, image::imageops::FilterType::Triangle);
    let luminance = |p: &Rgb<u8>| u32::from(p[0]) * 299 + u32::from(p[1]) * 587 + u32::from(p[2]) * 114;
    let mut edges = Vec::with_capacity(64);
    // A small luminance dead band keeps JPEG rounding in flat areas from inventing edges.
    for y in 0..8 { for x in 0..8 { edges.push(luminance(edge_image.get_pixel(x,y)) > luminance(edge_image.get_pixel(x+1,y)) + edge_threshold); } }
    Ok(Descriptor { width, height, spatial, histogram, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encode(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new()); image.write_to(&mut out, format).unwrap(); out.into_inner()
    }
    fn sample() -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(80, 48, |x,y| if x < 35 && y < 30 {Rgb([235,60,45])} else {Rgb([35,120,200])}))
    }
    #[test]
    fn appearance_descriptor_real_reencoding_and_resize_rank_before_different_image() {
        let a = describe(&encode(&sample(), ImageFormat::Png)).unwrap();
        let jpeg = describe(&encode(&sample(), ImageFormat::Jpeg)).unwrap();
        let resize = describe(&encode(&sample().resize_exact(160,96,image::imageops::FilterType::Triangle),ImageFormat::Png)).unwrap();
        let other = describe(&encode(&DynamicImage::ImageRgb8(RgbImage::from_pixel(80,48,Rgb([20,230,30]))),ImageFormat::Png)).unwrap();
        assert!(a.valid()); assert_eq!(distance(&a,&a).total,0.0);
        assert!(distance(&a,&jpeg).total < 0.15); assert!(distance(&a,&resize).total < 0.1);
        assert!(distance(&a,&other).total > distance(&a,&jpeg).total + 0.15);
    }
    #[test]
    fn appearance_descriptor_white_transparency_and_color_are_honest() {
        let transparent = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(8,8,image::Rgba([255,0,0,0])));
        let white = DynamicImage::ImageRgb8(RgbImage::from_pixel(8,8,Rgb([255,255,255])));
        let red = DynamicImage::ImageRgb8(RgbImage::from_pixel(8,8,Rgb([255,0,0])));
        let a = describe(&encode(&transparent,ImageFormat::Png)).unwrap();
        let b = describe(&encode(&white,ImageFormat::Png)).unwrap();
        assert_eq!(distance(&a,&b).total,0.0);
        assert!(distance(&a,&describe(&encode(&red,ImageFormat::Png)).unwrap()).total > 0.3);
    }
    #[test]
    fn appearance_descriptor_bad_bytes_limits_and_cache_validation() {
        assert!(describe(b"not an image").is_err()); assert!(describe(&vec![0;MAX_BYTES+1]).is_err());
        assert!(describe(b"GIF89a\x01\x00\x01\x00").unwrap_err().contains("GIF"));
        let mut a = describe(&encode(&sample(),ImageFormat::Bmp)).unwrap(); assert!(a.valid());
        a.histogram.push(0); assert!(!a.valid());
    }
    #[test]
    fn appearance_descriptor_actual_animation_orientation_and_decode_size_gates() {
        assert!(describe(include_bytes!("../../../tests/fixtures/material-appearance/animated.png")).unwrap_err().contains("动画"));
        assert!(describe(include_bytes!("../../../tests/fixtures/material-appearance/animated.webp")).unwrap_err().contains("动画"));
        let oriented=describe(include_bytes!("../../../tests/fixtures/material-appearance/oriented.jpg")).unwrap();
        let expected=describe(include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png")).unwrap();
        assert_eq!((oriented.width,oriented.height),(48,80));
        let delta=distance(&oriented,&expected);
        let wrong=describe(include_bytes!("../../../tests/fixtures/material-appearance/unoriented.jpg")).unwrap();
        let wrong_delta=distance(&wrong,&expected);
        let noisy_delta=distance(&describe_with_edge_threshold(include_bytes!("../../../tests/fixtures/material-appearance/oriented.jpg"),0).unwrap(),
            &describe_with_edge_threshold(include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png"),0).unwrap());
        println!("orientation: correct={delta:?}, wrong={wrong_delta:?}, original-zero-dead-band={noisy_delta:?}");
        assert!(delta.total<0.005,"orientation reference distance: {delta:?}");
        assert!(wrong_delta.total>delta.total+0.05,"correct orientation must be substantially closer");
        assert!(describe(&encode(&DynamicImage::new_rgb8(MAX_SIDE+1,1),ImageFormat::Png)).is_err());
        assert!(describe(&encode(&DynamicImage::new_rgb8(5000,4001),ImageFormat::Png)).is_err());
    }
}
