mod fmt;

pub trait Renderable {}

pub struct Widget;

impl Renderable for Widget {}

pub fn render(name: &str) -> String {
    fmt::format_name(name)
}
