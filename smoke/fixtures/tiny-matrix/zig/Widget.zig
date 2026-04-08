const helper = @import("Format.zig");

pub const Renderable = struct {};
pub const BaseWidget = struct {};

pub const Widget = struct {
    pub fn render(name: []const u8) []const u8 {
        return helper.formatName(name);
    }
};
