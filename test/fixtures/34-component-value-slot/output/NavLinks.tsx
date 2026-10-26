import { HomeIcon, InvoiceIcon } from "./icons";
import { NavLinksLink } from "./NavLinks.client";

const links = [
  { name: "Home", href: "/dashboard", icon: HomeIcon },
  { name: "Invoices", href: "/dashboard/invoices", icon: InvoiceIcon },
];

export default function NavLinks() {
  return (
    <>
      {links.map((link) => {
        const LinkIcon = link.icon;
        return (
          <NavLinksLink key={link.name} link={{ name: link.name, href: link.href }}>
            <LinkIcon className="w-6" />
          </NavLinksLink>
        );
      })}
    </>
  );
}
