#include "format.hpp"

class Widget {
public:
  std::string render(const std::string& name) {
    return format_label(name);
  }
};
