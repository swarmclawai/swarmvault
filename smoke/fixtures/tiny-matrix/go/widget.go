package tiny

import "example.com/tiny/go/helpers"

type Widget struct{}

func Run(name string) string {
	return helpers.FormatName(name)
}
