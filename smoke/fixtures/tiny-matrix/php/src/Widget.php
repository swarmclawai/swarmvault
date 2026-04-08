<?php

namespace Tiny\App;

use Tiny\App\BaseWidget;
use Tiny\App\Renderable;

class Widget extends BaseWidget implements Renderable
{
    public function run(string $name): string
    {
        return "Php:" . $name;
    }
}
